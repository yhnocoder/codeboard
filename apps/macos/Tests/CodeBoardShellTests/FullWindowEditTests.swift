import AppKit
import CodeBoardModel
import Foundation
import Testing

@testable import CodeBoardCanvas
@testable import CodeBoardNotes
@testable import CodeBoardShell

// Writing on a board in the whole window (sidebar, tab row, toolbar, the pane around the canvas), entered through the
// window as a person does it: a layout pass that changes no size (the window's display cycle runs one after every
// committed transaction) leaves what is being written open and the keyboard where it was

@MainActor @Suite(.serialized) struct FullWindowEditTests {
  let board = BoardID(rawValue: "w")

  func vault() throws -> Vault {
    let fm = FileManager.default
    let root = fm.temporaryDirectory.appending(path: "window-\(UUID().uuidString)")
    let vault = Vault(root: root)
    try fm.createDirectory(at: root, withIntermediateDirectories: true)
    func own(_ body: CardContent.Body, title: String? = nil) -> Card.Content {
      .own(CardContent(title: title, body: body))
    }
    let code = Segment(
      id: SegmentID(rawValue: "s1"), source: nil, language: "python", firstLine: 1,
      lines: ["def step(batch):", "    ids = batch.ids", "    return run(ids)"])
    try vault.newBoard(
      in: "", title: "W",
      board: Board(
        id: board,
        cards: [
          Card(
            id: CardID(rawValue: "n"), x: 0, y: 0, width: 240, height: 160, content: own(.note(Note(text: "a plan")))),
          Card(
            id: CardID(rawValue: "t"), x: 320, y: 0, width: 220,
            content: own(.text(TextCard(text: "Threads wait", wrap: true)))),
          Card(
            id: CardID(rawValue: "b"), x: 320, y: 200, width: 180,
            content: own(.text(TextCard(text: "Check the bounds", look: .box, wrap: true)))),
          Card(
            id: CardID(rawValue: "f"), x: 620, y: 0, width: 320,
            content: own(.code(CodeCard(segments: [code])), title: "Free")),
          Card(
            id: CardID(rawValue: "m"), x: 40, y: 480, width: 240, height: 120,
            section: SectionID(rawValue: "g"), content: own(.note(Note(text: "inside")))),
          Card(
            id: CardID(rawValue: "sb"), x: 680, y: 300, width: 220, height: 140,
            content: own(.board(SubBoard(board: BoardID(rawValue: "o"))))),
        ],
        arrows: [
          Arrow(
            id: ArrowID(rawValue: "a"), from: Endpoint(card: CardID(rawValue: "n")),
            to: Endpoint(card: CardID(rawValue: "t")), label: "calls")
        ],
        sections: [Section(id: SectionID(rawValue: "g"), title: "Group", x: 0, y: 400, width: 600, height: 300)]))
    // another board, the sub-board card's
    try vault.newBoard(
      in: "", title: "Other",
      board: Board(
        id: BoardID(rawValue: "o"),
        cards: [
          Card(id: CardID(rawValue: "on"), x: 0, y: 0, width: 240, height: 160, content: own(.note(Note(text: "o"))))
        ]))
    return vault
  }

  @MainActor final class Window {
    let window: NSWindow
    let panes: BoardPanes
    let shell: Shell
    let vault: Vault
    var pane: CanvasView? { shell.selected.flatMap { panes.panes[$0]?.canvas } }
    var canvas: CanvasView { pane! }

    init(_ vault: Vault, board: BoardID, cameras: CameraStore? = nil) {
      // from here on the test is watched: one stuck past the limit ends the process, saying which it was
      TestWatch.started(Test.current.map { "\($0.id)" } ?? "a test")
      self.vault = vault
      shell = Shell()
      shell.open(vault, restoring: nil)
      shell.apply(.success(try! vault.tree()))
      (window, panes) = makeMainWindow(shell: shell)
      panes.cameras = cameras
      window.setFrameAutosaveName("")
      window.level = .underDesktop
      window.orderFrontRegardless()
      shell.show(board)
      panes.sync()
    }

    func close(keepingVault: Bool = false) {
      TestWatch.ended()
      window.orderOut(nil)
      if !keepingVault { try? FileManager.default.removeItem(at: vault.root) }
    }

    /// The view the window gives a press at a board point to
    func hit(_ p: CGPoint) -> NSView? {
      guard let frame = window.contentView?.superview else { return nil }
      return frame.hitTest(frame.convert(at(p), from: nil))
    }

    /// A board point in the window
    func at(_ p: CGPoint) -> CGPoint { canvas.convert(canvas.camera.view(p), to: nil) }

    /// A double-click where the window's hit test puts it: the view under the point gets it as from the window (the
    /// test process is not the active app, so its window is never key and would take a first click for itself)
    func doubleClick(_ p: CGPoint) {
      let w = at(p)
      guard let view = hit(p) else { return }
      for clicks in [1, 2] {
        for type in [NSEvent.EventType.leftMouseDown, .leftMouseUp] {
          let e = NSEvent.mouseEvent(
            with: type, location: w, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
            windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: clicks, pressure: 1)!
          if type == .leftMouseDown { view.mouseDown(with: e) } else { view.mouseUp(with: e) }
        }
      }
    }

    /// A layout of the whole window that changes no size, then its display cycle, then a few frames
    func sameSizeLayout() async {
      let c = canvas
      c.setFrameSize(c.frame.size)
      c.frame = c.frame
      var v: NSView? = c
      while let view = v {
        view.needsLayout = true
        v = view.superview
      }
      window.contentView?.layoutSubtreeIfNeeded()
      window.displayIfNeeded()
      CATransaction.flush()
      await frames(6)
    }

    /// Frames of the canvas, a display's apart
    func frames(_ n: Int) async {
      for _ in 0..<n {
        pane?.tick(at: CACurrentMediaTime())
        try? await Task.sleep(for: .milliseconds(16))
      }
    }

    /// The keyboard is in this view or in one inside it
    func keysIn(_ view: NSView) -> Bool {
      guard let r = window.firstResponder as? NSView else { return false }
      return r === view || r.isDescendant(of: view)
    }
  }

  /// Until `f` holds, the canvas's frames ticking meanwhile (with the display asleep its display link gives none)
  func until(_ what: String, in w: Window? = nil, _ f: () -> Bool) async {
    let deadline = ContinuousClock.now + .seconds(30)
    while !f() {
      if ContinuousClock.now > deadline {
        Issue.record("\(what): not within 30 s")
        return
      }
      w?.pane?.tick(at: CACurrentMediaTime())
      try? await Task.sleep(for: .milliseconds(5))
    }
  }

  func opened(_ vault: Vault? = nil, cameras: CameraStore? = nil) async throws -> Window {
    let w = Window(try vault ?? self.vault(), board: board, cameras: cameras)
    await until("the board shown", in: w) { w.pane?.scene != nil && w.pane?.shown?.board.id == board }
    // under the desktop the window counts as hidden, where WebKit would hold the editor page's frames (as the rig does)
    w.canvas.noteEditor.drawOffScreen()
    w.window.contentView?.layoutSubtreeIfNeeded()
    await until("laid out", in: w) { w.canvas.window != nil && w.canvas.convert(w.canvas.bounds, to: nil).minX > 100 }
    // its first frames in
    await w.frames(12)
    return w
  }

  @Test(arguments: ["label", "title"])
  func writingALabelOrATitleGoesOnThroughALayoutThatChangesNoSize(_ what: String) async throws {
    let w = try await opened()
    defer { w.close() }
    let c = w.canvas
    let owner: Scene.Owner =
      what == "label" ? .arrowLabel(ArrowID(rawValue: "a")) : .sectionTitle(SectionID(rawValue: "g"))
    let i = try #require(c.index(of: owner))
    let r = try #require(c.scene?.items[i].rect)
    #expect(
      w.hit(CGPoint(x: r.midX, y: r.midY)).map { $0 === c } == true,
      "the canvas under it: \(String(describing: w.hit(CGPoint(x: r.midX, y: r.midY)))) at \(w.at(CGPoint(x: r.midX, y: r.midY)))"
    )
    w.doubleClick(CGPoint(x: r.midX, y: r.midY))
    let field = try #require(c.inPlace?.field, "the field is there")
    #expect(w.window.firstResponder === field.currentEditor(), "the field has the keyboard")
    await w.sameSizeLayout()
    #expect(c.inPlace?.field === field, "still writing")
    #expect(w.window.firstResponder === field.currentEditor(), "the keyboard still in the field")
  }

  @Test(arguments: ["n", "t", "b", "f"])
  func writingACardGoesOnThroughALayoutThatChangesNoSize(_ id: String) async throws {
    let w = try await opened()
    defer { w.close() }
    let c = w.canvas
    let card = CardID(rawValue: id)
    let r = try #require(c.scene?.items.first { $0.owner == .card(card) }?.rect)
    // the card in the middle of the view first (a board opens at 100 %, where it may be beyond the window's edge)
    c.place(zoom: 1, centre: CGPoint(x: r.midX, y: r.midY))
    await w.frames(6)
    var p = CGPoint(x: r.midX, y: r.midY)
    if id == "f", let code = c.scene?.placed[card]?.code, let row = code.layout.row(segment: 0, line: 2) {
      p = CGPoint(x: r.maxX - 10, y: r.minY + code.top + row.y + row.height / 2)
    }
    #expect(w.hit(p).map { $0 === c } == true, "the canvas under it: \(String(describing: w.hit(p)))")
    w.doubleClick(p)
    await until("the editor up", in: w) { c.editing?.ready == true }
    #expect(w.keysIn(c.noteEditor.view), "the keyboard in the editor: \(String(describing: w.window.firstResponder))")
    #expect(c.editing?.id == card)
    await w.sameSizeLayout()
    #expect(c.isEditing && c.editing?.id == card, "still writing")
    #expect(
      w.keysIn(c.noteEditor.view), "the keyboard still in the editor: \(String(describing: w.window.firstResponder))")
  }

  /// The app quit right after the camera moved (before it came to rest long enough to be written), then opened again
  /// on the same vault, its window and camera store made anew: the board opens where it was left
  @Test func aBoardOpensWhereItWasLeftAfterTheAppQuitAndOpenedTheVaultAgain() async throws {
    let fm = FileManager.default
    let store = CameraStore(folder: fm.temporaryDirectory.appending(path: "cameras-\(UUID().uuidString)"))
    defer { try? fm.removeItem(at: store.folder) }
    let v = try vault()
    defer { try? fm.removeItem(at: v.root) }
    let w = try await opened(v, cameras: store)
    // quit before the camera is written as at rest
    w.canvas.cameraDelay = .seconds(600)
    w.canvas.place(zoom: 0.62, centre: CGPoint(x: 333, y: 211))
    await w.frames(3)
    let left = w.canvas.currentCamera
    // what the app does on quitting (AppDelegate applicationShouldTerminate), then the window goes
    _ = w.panes.flush()
    w.close(keepingVault: true)
    let again = try await opened(v, cameras: CameraStore(folder: store.folder))
    defer { again.close(keepingVault: true) }
    #expect(again.canvas.currentCamera == left, "\(again.canvas.currentCamera) after \(left)")
  }

  /// The camera moved a moment before the board was left (its tab closed, another board shown in it, the app quitting
  /// with a drag still held): kept for the board at once, not after it would have come to rest
  @Test(arguments: ["tab", "board", "gesture"])
  func aBoardLeftRightAfterItsCameraMovedIsKeptWhereItWas(_ how: String) async throws {
    let fm = FileManager.default
    let store = CameraStore(folder: fm.temporaryDirectory.appending(path: "cameras-\(UUID().uuidString)"))
    defer { try? fm.removeItem(at: store.folder) }
    let w = try await opened(cameras: store)
    defer { w.close() }
    w.canvas.cameraDelay = .seconds(600)
    w.canvas.place(zoom: 0.62, centre: CGPoint(x: 333, y: 211))
    await w.frames(3)
    let c = w.canvas.currentCamera
    let left = BoardCamera(x: c.origin.x, y: c.origin.y, zoom: c.zoom)
    switch how {
    case "tab":
      w.shell.close(try #require(w.shell.selected))
      w.panes.sync()
    case "board":
      w.shell.show(BoardID(rawValue: "o"))
      w.panes.sync()
      await until("the other board shown", in: w) { w.pane?.shown?.board.id == BoardID(rawValue: "o") }
    default:
      // a marquee drag still held, the board scrolled under it, when the app quits
      let p = w.at(CGPoint(x: 580, y: 260))
      for (type, q) in [(NSEvent.EventType.leftMouseDown, p), (.leftMouseDragged, CGPoint(x: p.x + 30, y: p.y - 20))] {
        let e = NSEvent.mouseEvent(
          with: type, location: q, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
          windowNumber: w.window.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: 1)!
        if type == .leftMouseDown { w.canvas.mouseDown(with: e) } else { w.canvas.mouseDragged(with: e) }
      }
      #expect(w.canvas.gesture != nil, "the drag under way")
      for phase in [NSEvent.Phase.began, .changed, .changed] {
        w.window.sendEvent(try #require(Self.scroll(phase: phase, dy: phase == .began ? 0 : -40, in: w)))
      }
      await w.frames(2)
      let now = w.canvas.currentCamera
      #expect(now != c, "the scroll moved the camera")
      _ = w.panes.flush()
      #expect(store.cameras(for: w.vault)[board] == BoardCamera(x: now.origin.x, y: now.origin.y, zoom: now.zoom))
      return
    }
    #expect(store.cameras(for: w.vault)[board] == left, "\(String(describing: store.cameras(for: w.vault)[board]))")
  }

  /// A camera waiting for its rest delay and then one written at once (the board left): the one written at once stays,
  /// the waiting write does not come after it with the older camera
  @Test func aWaitingCameraWriteDoesNotComeAfterOneWrittenAtOnce() async throws {
    let fm = FileManager.default
    let store = CameraStore(folder: fm.temporaryDirectory.appending(path: "cameras-\(UUID().uuidString)"))
    defer { try? fm.removeItem(at: store.folder) }
    let w = try await opened(cameras: store)
    defer { w.close() }
    w.canvas.cameraDelay = .milliseconds(300)
    w.canvas.place(zoom: 0.8, centre: CGPoint(x: 100, y: 100))
    await w.frames(2)
    w.canvas.keepCamera()
    w.canvas.place(zoom: 0.62, centre: CGPoint(x: 333, y: 211))
    await w.frames(2)
    let c = w.canvas.currentCamera
    w.canvas.keepCamera(now: true)
    // past the delay of the waiting write
    await w.frames(40)
    #expect(store.cameras(for: w.vault)[board] == BoardCamera(x: c.origin.x, y: c.origin.y, zoom: c.zoom))
  }

  /// A trackpad scroll event at the middle of the canvas
  static func scroll(phase: NSEvent.Phase, dy: Int32 = 0, in w: Window) -> NSEvent? {
    guard let cg = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 2, wheel1: dy, wheel2: 0, wheel3: 0)
    else { return nil }
    let c = w.canvas
    let p = c.convert(CGPoint(x: c.bounds.midX, y: c.bounds.midY), to: nil)
    cg.location = CGPoint(x: p.x, y: (NSScreen.screens.first?.frame.height ?? 0) - p.y)
    cg.setIntegerValueField(.scrollWheelEventIsContinuous, value: 1)
    cg.setIntegerValueField(.scrollWheelEventScrollPhase, value: phase == .began ? 1 : 2)
    cg.setDoubleValueField(.scrollWheelEventPointDeltaAxis1, value: Double(dy))
    cg.setIntegerValueField(.mouseEventWindowUnderMousePointer, value: Int64(w.window.windowNumber))
    cg.setIntegerValueField(
      .mouseEventWindowUnderMousePointerThatCanHandleThisEvent, value: Int64(w.window.windowNumber))
    cg.timestamp = UInt64(ProcessInfo.processInfo.systemUptime * 1e9)
    return NSEvent(cgEvent: cg)
  }
}

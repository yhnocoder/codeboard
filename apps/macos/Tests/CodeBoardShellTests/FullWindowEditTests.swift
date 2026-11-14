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
        ],
        arrows: [
          Arrow(
            id: ArrowID(rawValue: "a"), from: Endpoint(card: CardID(rawValue: "n")),
            to: Endpoint(card: CardID(rawValue: "t")), label: "calls")
        ],
        sections: [Section(id: SectionID(rawValue: "g"), title: "Group", x: 0, y: 400, width: 600, height: 300)]))
    return vault
  }

  @MainActor final class Window {
    let window: NSWindow
    let panes: BoardPanes
    let shell: Shell
    let vault: Vault
    var pane: CanvasView? { shell.selected.flatMap { panes.panes[$0]?.canvas } }
    var canvas: CanvasView { pane! }

    init(_ vault: Vault, board: BoardID) {
      self.vault = vault
      shell = Shell()
      shell.open(vault, restoring: nil)
      shell.apply(.success(try! vault.tree()))
      (window, panes) = makeMainWindow(shell: shell)
      window.setFrameAutosaveName("")
      window.level = .underDesktop
      window.orderFrontRegardless()
      shell.show(board)
      panes.sync()
    }

    func close() {
      window.orderOut(nil)
      try? FileManager.default.removeItem(at: vault.root)
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

  func opened() async throws -> Window {
    let w = Window(try vault(), board: board)
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
}

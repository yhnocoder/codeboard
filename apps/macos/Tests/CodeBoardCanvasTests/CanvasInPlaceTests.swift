import AppKit
import CodeBoardModel
import Testing

@testable import CodeBoardCanvas

// An arrow's label and a Section's title written where they are, through the window as a person does it: a double-click
// on them (or Return with one selected) gives the field the keyboard, what is typed goes into it, Return keeps it, and a
// scroll meanwhile moves the board and leaves the field writing

extension Rig {
  /// What the window does with a mouse event: to the view under it
  func click(through p: CGPoint, clicks: Int = 1) {
    for type in [NSEvent.EventType.leftMouseDown, .leftMouseUp] {
      window.sendEvent(mouse(type, p, clicks: clicks))
    }
  }

  func doubleClick(through p: CGPoint) {
    click(through: p)
    click(through: p, clicks: 2)
  }

  /// The field being written in has the keyboard: its field editor is the window's first responder
  var fieldHasKeys: Bool {
    guard let f = canvas.inPlace?.field, let ed = f.currentEditor() else { return false }
    return window.firstResponder === ed
  }

  /// The camera on the label or the title (the window's view of the sample board leaves the title out)
  func look(at what: String) async throws {
    let owner: Scene.Owner =
      what == "label" ? .arrowLabel(ArrowID(rawValue: "a1")) : .sectionTitle(SectionID(rawValue: "g1"))
    let p = try #require(middle(owner))
    canvas.place(zoom: 1, centre: p)
    await idle()
  }

  /// The middle of an item's text on the board (a label, a title)
  func middle(_ owner: Scene.Owner) -> CGPoint? {
    guard let i = canvas.index(of: owner), let r = canvas.scene?.items[i].rect else { return nil }
    return CGPoint(x: r.midX, y: r.midY)
  }
}

@MainActor @Suite(.serialized) struct CanvasInPlaceTests {
  func labelled() -> Board {
    var b = sample()
    b.arrows[0].label = "calls"
    return b
  }

  @Test(arguments: ["label", "title"])
  func aDoubleClickWritesItWhereItIs(_ what: String) async throws {
    let r = try await Rig(labelled(), zoom: 1)
    defer { r.close() }
    let a = ArrowID(rawValue: "a1")
    let g = SectionID(rawValue: "g1")
    try await r.look(at: what)
    let p = try #require(what == "label" ? r.middle(.arrowLabel(a)) : r.middle(.sectionTitle(g)))
    r.doubleClick(through: p)
    #expect(r.canvas.inPlace != nil, "the field is there")
    #expect(r.fieldHasKeys, "the field has the keyboard: \(String(describing: r.window.firstResponder))")
    r.press("x\r")
    #expect(r.canvas.inPlace == nil, "Return keeps it")
    let saved = what == "label" ? r.doc.board.arrow(a)?.label : r.doc.board.section(g)?.title
    // all of it was selected: what is typed takes its place
    #expect(saved == "x")
  }

  /// Return with an arrow alone selected writes its label (keymap.ts editLabel); a Section has no Return (keymap.ts)
  @Test func returnOnTheSelectedArrowWritesItsLabel() async throws {
    let r = try await Rig(labelled(), zoom: 1)
    defer { r.close() }
    let a = ArrowID(rawValue: "a1")
    r.doc.select([.arrow(a)])
    r.window.makeFirstResponder(r.canvas)
    r.press("\r")
    #expect(r.fieldHasKeys, "the field has the keyboard")
    r.press("y\r")
    #expect(r.doc.board.arrow(a)?.label == "y")
  }

  @Test func editLabelInTheArrowsMenuWritesIt() async throws {
    let r = try await Rig(labelled(), zoom: 1)
    defer { r.close() }
    let a = ArrowID(rawValue: "a1")
    try await r.look(at: "label")
    let p = try #require(r.middle(.arrowLabel(a)))
    let item = try #require(r.canvas.menu(for: r.mouse(.rightMouseDown, p))?.items.first { $0.title == "Edit Label" })
    let action = try #require(item.action)
    NSApp.sendAction(action, to: item.target, from: item)
    #expect(r.fieldHasKeys, "the field has the keyboard")
    r.press("z\r")
    #expect(r.doc.board.arrow(a)?.label == "z")
  }

  @Test(arguments: ["label", "title"])
  func aScrollWhileWritingMovesTheBoardAndTheFieldGoesOn(_ what: String) async throws {
    let r = try await Rig(labelled(), zoom: 1)
    defer { r.close() }
    let a = ArrowID(rawValue: "a1")
    let g = SectionID(rawValue: "g1")
    try await r.look(at: what)
    let p = try #require(what == "label" ? r.middle(.arrowLabel(a)) : r.middle(.sectionTitle(g)))
    r.doubleClick(through: p)
    r.press("ab")
    let c0 = r.canvas.currentCamera
    _ = r.scrollGesture(from: p)
    #expect(r.canvas.currentCamera.origin != c0.origin, "the board moved")
    #expect(r.fieldHasKeys, "still writing")
    let f = try #require(r.canvas.inPlace?.field)
    let owner: Scene.Owner = what == "label" ? .arrowLabel(a) : .sectionTitle(g)
    let q = try #require(r.middle(owner))
    let v = r.canvas.convert(f.frame, from: f.superview)
    #expect(v.contains(r.canvas.camera.view(q)), "the field went with the board: \(v), \(r.canvas.camera.view(q))")
    r.press("c\r")
    let saved = what == "label" ? r.doc.board.arrow(a)?.label : r.doc.board.section(g)?.title
    #expect(saved == "abc")
  }
}

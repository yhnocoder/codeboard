import AppKit
import CodeBoardModel
import Foundation
import Testing

@testable import CodeBoardCanvas
@testable import CodeBoardShell

// The board's keys with no click on it first, however it came to the front (as on the VS Code board): opened, another
// board shown in the tab (the sidebar), back and forward, a tab switched to, into a sub-board, after writing ends;
// what is being typed in outside the boards (the sidebar's rename) keeps the keys

extension FullWindowEditTests.Window {
  /// The board shown in the tab selected, once it is drawn
  func shows(_ id: BoardID) -> Bool { pane?.shown?.board.id == id && pane?.scene != nil }

  /// The canvas in front has the keys
  var canvasHasKeys: Bool { pane.map { window.firstResponder === $0 } ?? false }

  /// N, as the window gives a key: a new Note on the board in front
  func pressN() {
    for type in [NSEvent.EventType.keyDown, .keyUp] {
      window.sendEvent(
        NSEvent.keyEvent(
          with: type, location: .zero, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
          windowNumber: window.windowNumber, context: nil, characters: "n", charactersIgnoringModifiers: "n",
          isARepeat: false, keyCode: 45)!)
    }
  }
}

extension FullWindowEditTests {
  /// What the keys do on the board in front: N makes a Note there
  func keysWork(_ w: Window, _ what: String) async {
    #expect(w.canvasHasKeys, "\(what): the canvas has the keys, not \(String(describing: w.window.firstResponder))")
    guard let doc = w.pane?.document else { return }
    let n = doc.board.cards.count
    w.pressN()
    await until("\(what): N made a Note", in: w) { doc.board.cards.count == n + 1 }
    // and out of writing in it: the keys back on the canvas
    await until("\(what): writing it", in: w) { w.canvas.editing?.ready == true }
    await w.canvas.endEditing()
    await w.frames(2)
    #expect(w.canvasHasKeys, "\(what), writing ended: \(String(describing: w.window.firstResponder))")
  }

  func show(_ w: Window, _ id: BoardID, _ change: () -> Void) async {
    change()
    w.panes.sync()
    await until("\(id.rawValue) shown", in: w) { w.shows(id) }
    await w.frames(4)
  }

  @Test func theBoardInFrontTakesTheKeysHoweverItCameThere() async throws {
    let w = try await opened()
    defer { w.close() }
    let other = BoardID(rawValue: "o")
    await keysWork(w, "opened")
    // the sidebar's click on another board, the keys somewhere else meanwhile
    w.window.makeFirstResponder(nil)
    await show(w, other) { w.shell.show(other) }
    await keysWork(w, "shown from the sidebar")
    await show(w, board) { w.shell.goBack() }
    await keysWork(w, "back")
    await show(w, other) { w.shell.goForward() }
    await keysWork(w, "forward")
    // a new tab, then the first again
    let first = try #require(w.shell.selected)
    await show(w, board) { w.shell.show(board, newTab: true) }
    await keysWork(w, "a new tab")
    await show(w, other) { w.shell.select(first) }
    await keysWork(w, "a tab switched to")
    // into a sub-board, from the board's card
    await show(w, board) { w.shell.goBack() }
    w.window.makeFirstResponder(nil)
    await show(w, other) { _ = w.canvas.openSubBoard(CardID(rawValue: "sb")) }
    await keysWork(w, "into a sub-board")
  }

  @Test func whatIsTypedInOutsideTheBoardsKeepsTheKeys() async throws {
    let w = try await opened()
    defer { w.close() }
    // a field outside the boards being typed in, as the sidebar's rename is
    let field = NSTextField(string: "W")
    field.frame = CGRect(x: 10, y: 10, width: 120, height: 22)
    w.window.contentView?.addSubview(field)
    w.window.makeFirstResponder(field)
    let editor = try #require(field.currentEditor())
    await show(w, BoardID(rawValue: "o")) { w.shell.show(BoardID(rawValue: "o")) }
    #expect(w.window.firstResponder === editor, "still in the field: \(String(describing: w.window.firstResponder))")
  }
}

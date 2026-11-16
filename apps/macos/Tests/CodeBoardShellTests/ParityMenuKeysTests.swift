import AppKit
import CodeBoardCanvas
import Testing

@testable import CodeBoardShell

// The app menu's keys that are the web board's (packages/board/src/keymap.ts):
// what each key equivalent does is its item's action

@MainActor private func items(_ m: NSMenu) -> [NSMenuItem] {
  m.items.flatMap { [$0] + ($0.submenu.map(items) ?? []) }
}

@MainActor @Suite struct ParityMenuKeysTests {
  /// The actions of the items each key fires
  func actions(_ key: String, _ mask: NSEvent.ModifierFlags) -> [Selector] {
    _ = NSApplication.shared
    return items(AppDelegate().mainMenu()).filter { $0.keyEquivalent == key && $0.keyEquivalentModifierMask == mask }
      .compactMap(\.action)
  }

  /// The toolbar's ⋯ sends Rename Board…, Edit Mark…, Settings… and Theme ▸ up the responder chain: the app answers
  /// them (MenuWalkTests counts them on)
  @Test func theAppAnswersTheToolbarsMoreMenu() {
    _ = NSApplication.shared
    let app = AppDelegate()
    for s in ["renameBoard:", "editMark:", "showSettings:", "chooseTheme:"] {
      #expect(app.responds(to: Selector((s))), "\(s)")
    }
  }

  /// ⌘L is File ▸ Open Location…, as in a browser
  @Test func lockIsCommandShiftL() {
    #expect(actions("l", [.command, .shift]) == [#selector(CanvasView.lock(_:))])
    #expect(actions("l", .command) == [NSSelectorFromString("openLocation:")])
  }

  /// ⌃- and ⌃⇧- go back and forward (keymap.ts navBack, navForward), as ⌘[ and ⌘] do
  @Test func controlMinusAndCommandBracketsGoBackAndForward() {
    #expect(actions("-", .control) == [#selector(AppDelegate.goBack(_:))])
    #expect(actions("-", [.control, .shift]) == [#selector(AppDelegate.goForward(_:))])
    #expect(actions("[", .command) == [#selector(AppDelegate.goBack(_:))])
    #expect(actions("]", .command) == [#selector(AppDelegate.goForward(_:))])
  }

  /// ⌘Y redoes as ⇧⌘Z does
  @Test func commandYRedoes() {
    #expect(actions("y", .command) == [#selector(CanvasView.redo(_:))])
    #expect(actions("Z", .command) == [#selector(CanvasView.redo(_:))])
  }

  /// Bring to Front and Send to Back are ⌥⇧⌘F and ⌥⇧⌘B; ⇧⌘] and ⇧⌘[ only switch tabs (NOT DO: main's order keys)
  @Test func orderKeysAreTheAppsOwnAndBracketsSwitchTabs() {
    #expect(actions("f", [.command, .option, .shift]) == [#selector(CanvasView.bringToFront(_:))])
    #expect(actions("b", [.command, .option, .shift]) == [#selector(CanvasView.sendToBack(_:))])
    #expect(actions("]", [.command, .shift]) == [#selector(AppDelegate.showNextTab(_:))])
    #expect(actions("[", [.command, .shift]) == [#selector(AppDelegate.showPreviousTab(_:))])
  }

  /// ⌃Tab and ⌃⇧Tab switch tabs too; ⇧Tab comes from a keyboard as a back tab
  @Test func controlTabSwitchesTabsBothWays() {
    #expect(actions("\t", .control) == [#selector(AppDelegate.showNextTab(_:))])
    #expect(actions("\t", [.control, .shift]) == [#selector(AppDelegate.showPreviousTab(_:))])
    #expect(actions("\u{19}", [.control, .shift]) == [#selector(AppDelegate.showPreviousTab(_:))])
  }
}

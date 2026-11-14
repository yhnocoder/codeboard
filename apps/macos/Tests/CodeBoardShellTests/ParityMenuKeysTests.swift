import AppKit
import CodeBoardCanvas
import Testing

@testable import CodeBoardShell

// The app menu's keys that are the web board's (packages/board/src/keymap.ts; apps/macos/review/parity-keys-menus.md):
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

  /// The toolbar's ⋯ sends Rename Board… and Edit Mark… up the responder chain: the app answers them
  @Test func theAppAnswersRenameBoardAndEditMark() {
    _ = NSApplication.shared
    let app = AppDelegate()
    #expect(
      app.responds(to: #selector(AppDelegate.renameBoard(_:))) && app.responds(to: #selector(AppDelegate.editMark(_:))))
  }

  @Test func lockIsCommandShiftL() {
    #expect(actions("l", [.command, .shift]) == [#selector(CanvasView.lock(_:))])
    #expect(actions("l", .command).isEmpty)
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
}

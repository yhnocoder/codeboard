import AppKit
import CodeBoardModel
import Foundation
import Testing

@testable import CodeBoardCanvas
@testable import CodeBoardShell

// The shortcut list in the whole window (BoardView.tsx Keys, styles.css .keys, themes.css look-ink-wash .keys): pinned
// to the board's top right, 380 wide, 56 from the top and 60 from the bottom, on the theme's opaque paper in its
// fonts; typed into, its filter keeps what matches; its X closes it. Every key of the app menu is in it.

@MainActor @Suite(.serialized) struct FullWindowKeysTests {
  func open(_ theme: Theme.ID) async throws -> (FullWindowEditTests.Window, KeysPanel) {
    let w = try await FullWindowEditTests().opened()
    w.shell.theme = theme
    await FullWindowEditTests().until("the theme on the board", in: w) { w.canvas.theme.id == theme }
    let e = NSEvent.keyEvent(
      with: .keyDown, location: .zero, modifierFlags: .shift, timestamp: 0, windowNumber: w.window.windowNumber,
      context: nil, characters: "?", charactersIgnoringModifiers: "?", isARepeat: false, keyCode: 44)!
    w.window.makeFirstResponder(w.canvas)
    w.canvas.keyDown(with: e)
    return (w, try #require(w.canvas.keysPanel, "? opens it"))
  }

  /// Pinned: 12 from the right, 56 from the top, 60 from the bottom, 380 wide, and so after the window is resized
  func pinned(_ k: KeysPanel, in c: CanvasView) -> Bool {
    let f = k.frame
    return abs(f.maxX - (c.bounds.width - 12)) < 0.5 && abs(f.minY - 56) < 0.5
      && abs(f.maxY - (c.bounds.height - 60)) < 0.5 && f.width == 380
  }

  @Test(arguments: [Theme.ID.warmInk, .inkWash]) func theListIsPinnedOpaqueAndInTheThemesFonts(
    _ theme: Theme.ID
  ) async throws {
    let (w, k) = try await open(theme)
    defer { w.close() }
    let c = w.canvas
    w.window.contentView?.layoutSubtreeIfNeeded()
    #expect(pinned(k, in: c), "\(k.frame) in \(c.bounds)")
    w.window.setContentSize(CGSize(width: w.window.frame.width - 120, height: w.window.frame.height - 90))
    w.window.contentView?.layoutSubtreeIfNeeded()
    #expect(pinned(k, in: c), "after a resize: \(k.frame) in \(c.bounds)")
    // the theme's own paper, nothing of the board through it
    #expect(k.face.backgroundColor == c.theme.surface && k.face.backgroundColor?.alpha == 1)
    #expect(k.face.cornerRadius == (theme == .inkWash ? 2 : 14))
    let serif = theme == .inkWash
    for f in [k.title.font, k.labelFont] {
      #expect(f?.fontName.hasPrefix("SourceSerif4") == serif, "\(String(describing: f?.fontName))")
    }
  }

  /// Open while the theme changes: it is drawn in the new one at once, where it was
  @Test func anOpenListTakesANewTheme() async throws {
    let (w, k) = try await open(.warmInk)
    defer { w.close() }
    w.shell.theme = .inkWash
    await FullWindowEditTests().until("the theme on the board", in: w) { w.canvas.theme.id == .inkWash }
    let now = try #require(w.canvas.keysPanel, "still open")
    #expect(now.face.cornerRadius == 2 && now.title.font?.fontName.hasPrefix("SourceSerif4") == true)
    #expect(now.frame == k.frame)
  }

  /// Typed into, the filter keeps what matches as main's Filter shortcuts… does; nothing: its sentence. The X closes it
  @Test func theFilterKeepsWhatMatchesAndTheXCloses() async throws {
    let (w, k) = try await open(.warmInk)
    defer { w.close() }
    #expect(k.search.placeholderString == "Filter shortcuts…")
    w.window.makeFirstResponder(k.search)
    let typing = try #require(w.window.firstResponder as? NSTextView, "the field takes the keys")
    typing.insertText("zoom", replacementRange: NSRange(location: NSNotFound, length: 0))
    #expect(k.shown.flatMap(\.rows).map(\.label) == ["Zoom to 100%", "Zoom In", "Zoom Out", "Zoom"])
    #expect(k.empty.isHidden)
    typing.insertText("qq", replacementRange: NSRange(location: NSNotFound, length: 0))
    #expect(k.shown.isEmpty && !k.empty.isHidden && k.empty.stringValue == "No shortcut matches “zoomqq”.")
    typing.selectAll(nil)
    typing.deleteBackward(nil)
    #expect(k.shown.map(\.name) == k.groups.map(\.name))
    // the X, pressed where the window's hit test puts the press
    let r = k.closeRect
    let at = k.convert(CGPoint(x: r.midX, y: r.midY), to: nil)
    let frame = try #require(w.window.contentView?.superview)
    let hit = try #require(frame.hitTest(frame.convert(at, from: nil)))
    #expect(hit === k, "the X is the list's: \(hit)")
    for type in [NSEvent.EventType.leftMouseDown, .leftMouseUp] {
      let e = NSEvent.mouseEvent(
        with: type, location: at, modifierFlags: [], timestamp: 0, windowNumber: w.window.windowNumber, context: nil,
        eventNumber: 0, clickCount: 1, pressure: 1)!
      if type == .leftMouseDown { hit.mouseDown(with: e) } else { hit.mouseUp(with: e) }
    }
    #expect(w.canvas.keysPanel == nil && k.superview == nil)
  }

  /// Every key the app menu has (the system's own Hide, Hide Others, Quit and Minimize aside) is in the list
  @Test func everyKeyOfTheAppMenuIsListed() {
    _ = NSApplication.shared
    let listed = KeysPanel.rows().flatMap(\.rows).map(\.key)
    let system: Set<String> = ["Hide CodeBoard", "Hide Others", "Quit CodeBoard", "Minimize"]
    func walk(_ m: NSMenu) {
      for i in m.items {
        if let s = i.submenu { walk(s) }
        let key = KeysPanel.keyText(i)
        guard !key.isEmpty, !system.contains(i.title), !(i.isHidden && i.title == "Redo") else { continue }
        #expect(
          listed.contains { $0 == key || $0.contains(" / \(key)") || $0.hasPrefix("\(key) / ") }, "\(i.title) \(key)")
      }
    }
    walk(AppDelegate().mainMenu())
  }
}

import AppKit
import CodeBoardModel
import CodeBoardTestGuard
import Foundation
import Testing

@testable import CodeBoardCanvas
@testable import CodeBoardShell

// Anything pressed in the window stops the board's glide at once, whatever takes the press: the board, what floats
// over it (the toolbar, the dock, the Shelf, a ref's preview, the sticker palette, the shortcut list's rows and its
// search field), the sidenote popup, the Note or Free code being written; a right press (a menu comes up there) and a
// key too. The window stops it before the event goes on (BoardWindow), so each is given to the window as the app gets
// it. The canvas's frames are stepped by the test from the glide on.

@MainActor @Suite(.serialized) struct FullWindowGlideTests {
  enum Overlay: String, CaseIterable {
    case board, toolbar, dock, shelf, shelfThumb, shelfPreview, refPeek, stickerPalette, keys, keysRow, keysSearch
    case sidenotePop, editingNote, editingFreeCode
  }

  func find<T: NSView>(_ type: T.Type, in v: NSView) -> T? {
    if let t = v as? T { return t }
    for s in v.subviews { if let t = find(type, in: s) { return t } }
    return nil
  }

  /// The overlay shown, and a point of it (its own points) on no control of its own
  func show(_ o: Overlay, _ w: FullWindowEditTests.Window) async throws -> (NSView, CGPoint) {
    let c = w.canvas
    func ready(_ what: String, _ f: () -> Bool) async {
      await FullWindowEditTests().until(what, in: w, f)
    }
    switch o {
    case .board:
      return (c, CGPoint(x: c.bounds.midX, y: c.bounds.midY))
    case .toolbar:
      let content = try #require(w.window.contentView)
      let bar = try #require(find(CanvasToolbar.self, in: content))
      return (bar, CGPoint(x: bar.bounds.midX, y: bar.bounds.midY))
    case .dock:
      return (c.dock, CGPoint(x: c.dock.bounds.midX, y: c.dock.bounds.midY))
    case .shelf, .shelfThumb, .shelfPreview:
      c.toggleShelf()
      let p = try #require(c.shelfPanel)
      if o == .shelf { return (p, CGPoint(x: p.bounds.midX, y: p.bounds.maxY - 6)) }
      c.document?.select([.card(CardID(rawValue: "t"))])
      c.moveToShelf(nil)
      let id = try #require(c.document?.board.shelf.first?.id)
      await ready("its thumbnail") { p.thumbRect(id) != nil }
      if o == .shelfThumb {
        let r = try #require(p.thumbRect(id))
        return (p, CGPoint(x: r.midX, y: r.midY))
      }
      c.togglePreview(id)
      let v = try #require(c.shelfPreview)
      await ready("its picture") { v.frame.width > 0 }
      return (v, CGPoint(x: v.bounds.midX, y: v.bounds.midY))
    case .refPeek:
      let n = try #require(c.scene?.items.first { $0.owner == .card(CardID(rawValue: "n")) }?.rect)
      c.openRefPeek(
        key: "x", at: .card(CardID(rawValue: "n"), CGRect(x: n.minX + 10, y: n.minY + 10, width: 40, height: 16)),
        card: CardID(rawValue: "b"), on: nil)
      let peek = try #require(c.refPeek)
      await ready("the preview drawn") { peek.ready }
      return (peek, CGPoint(x: peek.bounds.midX, y: peek.bounds.midY))
    case .stickerPalette:
      c.toggleStickerPalette(above: CGRect(x: c.bounds.midX, y: c.bounds.maxY - 80, width: 30, height: 30))
      let p = try #require(c.stickerPalette)
      return (p, CGPoint(x: p.bounds.midX, y: p.bounds.maxY - 4))
    case .keys, .keysRow, .keysSearch:
      c.toggleKeys()
      let k = try #require(c.keysPanel)
      w.window.contentView?.layoutSubtreeIfNeeded()
      func rows() -> [NSTextField] { k.scroll.documentView?.subviews.compactMap { $0 as? NSTextField } ?? [] }
      await ready("its rows") { !rows().isEmpty && k.search.frame.width > 0 }
      if o == .keys { return (k, CGPoint(x: k.bounds.minX + 4, y: k.bounds.minY + 4)) }
      if o == .keysSearch { return (k.search, CGPoint(x: k.search.bounds.midX, y: k.search.bounds.midY)) }
      #expect(
        rows().allSatisfy { !$0.isSelectable }, "a row's words are not selected, as main's (.chrome: user-select none)")
      // one in view: the list's first row
      let seen = k.scroll.documentVisibleRect
      let row = try #require(rows().first { $0.frame.minY > seen.minY + 20 && $0.frame.maxY < seen.maxY })
      return (row, CGPoint(x: row.bounds.midX, y: row.bounds.midY))
    case .sidenotePop:
      c.openAddNote(.spot(.card(CardID(rawValue: "n"))))
      let v = c.sidenotePop.view
      // the slip itself (the view has room round it, for its shadow and the [[ list, that presses go through)
      await ready("the popup up") { c.popShown != nil && v.window != nil && v.alphaValue > 0 && v.popRect.width > 0 }
      return (v, CGPoint(x: v.popRect.midX, y: v.popRect.midY))
    case .editingNote, .editingFreeCode:
      let id = CardID(rawValue: o == .editingNote ? "n" : "f")
      let r = try #require(c.scene?.items.first { $0.owner == .card(id) }?.rect)
      c.place(zoom: 1, centre: CGPoint(x: r.midX, y: r.midY))
      await w.frames(6)
      var p = CGPoint(x: r.midX, y: r.midY)
      if let code = c.scene?.placed[id]?.code, let row = code.layout.row(segment: 0, line: 2) {
        p = CGPoint(x: r.maxX - 10, y: r.minY + code.top + row.y + row.height / 2)
      }
      w.doubleClick(p)
      await ready("the editor up") { c.editing?.ready == true }
      // the native editor for a Note, on its text (beside it the press is the canvas's); Free code's own, at the press
      let v = try #require(c.writingView)
      if c.editing?.writer != nil { return (v, CGPoint(x: v.bounds.midX, y: v.bounds.midY)) }
      return (v, v.convert(w.at(p), from: nil))
    }
  }

  enum Press: String, CaseIterable {
    case left, right, key
  }

  @Test(arguments: Overlay.allCases) func aPressAnywhereInTheWindowStopsTheGlide(_ o: Overlay) async throws {
    try await glideStopped(on: o, by: .left)
  }

  /// A right press on the board (its menu written down, never shown: TestGuard) and a key
  @Test(arguments: [Press.right, .key]) func aRightPressOrAKeyStopsTheGlide(_ p: Press) async throws {
    try await glideStopped(on: .board, by: p)
  }

  func glideStopped(on o: Overlay, by press: Press) async throws {
    let w = try await FullWindowEditTests().opened()
    defer { w.close() }
    let c = w.canvas
    let (view, p) = try await show(o, w)
    let at = view.convert(p, to: nil)
    let frame = try #require(w.window.contentView?.superview)
    let hit = try #require(frame.hitTest(frame.convert(at, from: nil)), "\(o.rawValue): nothing under \(at)")
    #expect(hit === view || hit.isDescendant(of: view), "\(o.rawValue): the press goes to \(hit)")
    // the frames from here on are the test's
    var t = max(c.lastTick, CACurrentMediaTime()) + 1
    c.steppedClock = { t }
    defer { c.steppedClock = nil }
    c.scroll(by: .zero, at: t, began: true, ended: false)
    for _ in 0..<10 {
      t += 1.0 / 120
      c.scroll(by: CGVector(dx: 0, dy: -12), at: t, began: false, ended: false)
    }
    t += 1.0 / 120
    c.scroll(by: .zero, at: t, began: false, ended: true)
    func tick() {
      t += 1.0 / 60
      c.tick(at: t)
    }
    for _ in 0..<3 { tick() }
    guard case .glide = c.motion.phase else { return #expect(Bool(false), "\(o.rawValue): not gliding") }
    let e =
      press == .key
      ? NSEvent.keyEvent(
        with: .keyDown, location: .zero, modifierFlags: [], timestamp: t, windowNumber: w.window.windowNumber,
        context: nil, characters: "j", charactersIgnoringModifiers: "j", isARepeat: false, keyCode: 38)!
      : NSEvent.mouseEvent(
        with: press == .left ? .leftMouseDown : .rightMouseDown, location: at, modifierFlags: [], timestamp: t,
        windowNumber: w.window.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: 1)!
    if press == .right {
      try #require(TestGuard.guardsContextMenus, "the menu guard is not in")
      TestGuard.shown = []
    }
    w.window.sendEvent(e)
    if press == .right { #expect(TestGuard.shown.first?.hasPrefix("menu: ") == true, "\(TestGuard.shown)") }
    let there = c.camera
    for _ in 0..<3 { tick() }
    #expect(c.camera == there, "\(o.rawValue): moved on to \(c.camera.origin) from \(there.origin)")
  }
}

import AppKit
import CodeBoardModel
import Foundation
import Testing

@testable import CodeBoardCanvas
@testable import CodeBoardShell

// A press on what floats over the board (the toolbar, the dock, the Shelf, a ref's preview, the sticker palette, the
// shortcut list) stops the board's glide as a press on the board does: in the whole window, the press given to the view
// the window's hit test finds. The canvas's frames are stepped by the test from the glide on.

@MainActor @Suite(.serialized) struct FullWindowGlideTests {
  enum Overlay: String, CaseIterable {
    case toolbar, dock, shelf, shelfThumb, shelfPreview, refPeek, stickerPalette, keys
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
    case .keys:
      c.toggleKeys()
      let k = try #require(c.keysPanel)
      return (k, CGPoint(x: k.bounds.minX + 4, y: k.bounds.minY + 4))
    }
  }

  @Test(arguments: Overlay.allCases) func aPressOnWhatFloatsOverTheBoardStopsItsGlide(_ o: Overlay) async throws {
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
    let e = NSEvent.mouseEvent(
      with: .leftMouseDown, location: at, modifierFlags: [], timestamp: t, windowNumber: w.window.windowNumber,
      context: nil, eventNumber: 0, clickCount: 1, pressure: 1)!
    hit.mouseDown(with: e)
    let there = c.camera
    for _ in 0..<3 { tick() }
    #expect(c.camera == there, "\(o.rawValue): moved on to \(c.camera.origin) from \(there.origin)")
  }
}

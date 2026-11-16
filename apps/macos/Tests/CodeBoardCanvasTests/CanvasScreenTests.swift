import AppKit
import Testing

@testable import CodeBoardCanvas

// The canvas as its window goes between screens and to the Dock: nothing is drawn while it moves, once when it stops
@MainActor @Suite(.serialized) struct CanvasScreenTests {
  @Test func aScreenOfAnotherScaleIsDrawnForOnceTheWindowHasStoppedMoving() async throws {
    let r = try await Rig(zoom: 1)
    defer { r.close() }
    await r.settle()
    await r.idle()
    let c = r.canvas
    #expect(c.restBacking == c.backing)
    c.backingDelay = .milliseconds(60)
    // drawn for the other screen, dragged across both: its scale changes back and forth as it moves
    let other: CGFloat = c.backing == 2 ? 1 : 2
    c.restBacking = other
    for _ in 0..<5 {
      c.viewDidChangeBackingProperties()
      NotificationCenter.default.post(name: NSWindow.didMoveNotification, object: r.window)
      #expect(c.restBacking == other && c.queue.isIdle, "nothing drawn while it moves")
    }
    await r.until("drawn once it stopped") { c.restBacking == c.backing }
    // on the scale it was drawn for: nothing more
    c.viewDidChangeBackingProperties()
    await c.backingSettle?.value
    #expect(c.backingSettle == nil && c.restBacking == c.backing)
  }

  @Test func aMiniaturizedWindowDrawsNothingAndWhatIsInViewOnceWhenBack() async throws {
    let r = try await Rig(zoom: 1)
    defer { r.close() }
    await r.settle()
    await r.idle()
    let c = r.canvas
    NotificationCenter.default.post(name: NSWindow.didMiniaturizeNotification, object: r.window)
    #expect(!c.onScreen && c.link?.isPaused == true && c.queue.isIdle)
    c.restBacking = nil
    c.arrive()
    #expect(c.restBacking == nil && c.queue.isIdle, "nothing planned in the Dock")
    NotificationCenter.default.post(name: NSWindow.didDeminiaturizeNotification, object: r.window)
    #expect(c.onScreen && c.restBacking == c.backing)
  }
}

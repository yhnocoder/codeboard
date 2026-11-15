import AppKit

/// A view of clickable controls with main's hover (markdown.css .md-bb:hover and the like): the control under the pointer
/// is `hovered`, drawn by the view with its chip; the pointer is a pointing hand over a control (cursor: pointer) and an
/// arrow elsewhere; each control's name is its tooltip
@MainActor
class HoverControls: NSView {
  /// the control under the pointer, by its id
  private(set) var hovered: String?
  /// the controls: id, box in the view's points, tooltip
  func controls() -> [(id: String, box: CGRect, tip: String)] { [] }

  override func updateTrackingAreas() {
    super.updateTrackingAreas()
    for a in trackingAreas where a.owner === self { removeTrackingArea(a) }
    addTrackingArea(
      NSTrackingArea(
        rect: .zero, options: [.mouseMoved, .mouseEnteredAndExited, .cursorUpdate, .activeAlways, .inVisibleRect],
        owner: self))
  }

  /// the tooltips again, after the controls changed
  func refreshTips() {
    removeAllToolTips()
    for c in controls() where !c.tip.isEmpty { addToolTip(c.box, owner: c.tip as NSString, userData: nil) }
  }

  func hover(at p: CGPoint?) {
    let id = p.flatMap { p in controls().first { $0.box.contains(p) }?.id }
    guard id != hovered else { return }
    hovered = id
    needsDisplay = true
    (id == nil ? NSCursor.arrow : NSCursor.pointingHand).set()
  }

  override func mouseMoved(with e: NSEvent) { hover(at: convert(e.locationInWindow, from: nil)) }
  override func mouseEntered(with e: NSEvent) { hover(at: convert(e.locationInWindow, from: nil)) }
  override func mouseExited(with e: NSEvent) { hover(at: nil) }
  override func cursorUpdate(with e: NSEvent) {
    let p = convert(e.locationInWindow, from: nil)
    (controls().contains { $0.box.contains(p) } ? NSCursor.pointingHand : NSCursor.arrow).set()
  }
  override func resetCursorRects() {
    for c in controls() { addCursorRect(c.box, cursor: .pointingHand) }
  }
}

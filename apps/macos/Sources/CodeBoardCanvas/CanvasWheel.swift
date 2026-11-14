import AppKit

// Scrolling and pinching over what is being written on the board (main interact.ts canvasWheel / ownerFor): the editor
// over a Note, Text or Box, a summary's editor, a label's or a title's field are part of the board, so a scroll or a pinch
// that begins over one moves the board as over any card (an editing Note has no scroll of its own: it is as tall as its
// text). A gesture the board took keeps going on the board, its momentum too, whatever comes under the pointer (main:
// `panning`). One that begins over the board's chrome (a sidenote's popover, the question list, the Shelf, the sticker
// palette) stays there, as main's nodrag panels outside the world. The window sends each event to the view under the
// pointer, so the views on the board hand the board's gestures back to it (`take`), and an event monitor of the app
// routes what passes over the chrome before it is sent.

/// Who has the scroll and the pinch gesture now
struct WheelOwner {
  /// The board took the scroll gesture; when it last had an event of it
  var scrollAt: TimeInterval?
  var pinching = false

  /// main WHEEL_GESTURE: a scroll with no phases (a mouse wheel) is a new gesture after this long without an event
  static let gap: TimeInterval = 0.2

  /// Whether the board takes this scroll event: a gesture's first event `over` the board, any later one of a gesture it
  /// took
  mutating func scroll(began: Bool, phased: Bool, momentum: Bool, ended: Bool, over: Bool, at t: TimeInterval) -> Bool {
    let continuing = scrollAt.map { t - $0 <= WheelOwner.gap } ?? false
    let mine = began ? over : momentum || phased ? continuing : continuing || over
    scrollAt = mine && !(ended && momentum) ? t : nil
    return mine
  }

  mutating func pinch(began: Bool, ended: Bool, over: Bool) -> Bool {
    if began { pinching = over }
    let mine = pinching
    if ended { pinching = false }
    return mine
  }
}

extension CanvasView {
  /// The views over the board that are part of it while they show: what is being written in a card, a summary, a label
  /// or a title
  var onBoardViews: [NSView] {
    var out: [NSView] = []
    if editing != nil, noteEditor.view.superview === superview { out.append(noteEditor.view) }
    if let f = inPlace?.field { out.append(f) }
    if let ed = summaryEditor { out += [ed, ed.ring] }
    return out
  }

  /// Whether a window point is over the board: the canvas or one of the views on it, and nothing over those
  func isOverBoard(_ p: CGPoint) -> Bool {
    guard let window, let frame = window.contentView?.superview ?? window.contentView,
      let hit = frame.hitTest(frame.convert(p, from: nil))
    else { return false }
    return hit === self || hit.isDescendant(of: self)
      || onBoardViews.contains { hit === $0 || hit.isDescendant(of: $0) }
  }

  func watchWheel() {
    if let m = wheelMonitor { NSEvent.removeMonitor(m) }
    wheelMonitor = nil
    guard window != nil else { return }
    wheelMonitor = NSEvent.addLocalMonitorForEvents(matching: [.scrollWheel, .magnify]) { [weak self] e in
      guard let self else { return e }
      return self.route(e, at: e.locationInWindow) ? nil : e
    }
  }

  /// Takes a scroll or pinch event at `p` (window coordinates) for the board (true) or leaves it to the view under the
  /// pointer
  package func route(_ e: NSEvent, at p: CGPoint) -> Bool {
    e.window === window && take(e, at: p)
  }

  /// A scroll or pinch event the window sent to the canvas or to a view on the board: the board moves when the
  /// gesture is its (true); one it does not own is the view's
  func take(_ e: NSEvent, at p: CGPoint) -> Bool {
    guard window != nil, !isHiddenOrHasHiddenAncestor, scene != nil else { return false }
    let over = isOverBoard(p)
    if over { pointerInWindow = p }
    switch e.type {
    case .scrollWheel:
      let began = !e.phase.isDisjoint(with: [.began, .mayBegin])
      let mine = wheel.scroll(
        began: began, phased: !e.phase.isEmpty, momentum: !e.momentumPhase.isEmpty,
        ended: !e.momentumPhase.isDisjoint(with: [.ended, .cancelled]), over: over, at: e.timestamp)
      if mine { scrollBoard(e) }
      return mine
    case .magnify:
      let mine = wheel.pinch(
        began: e.phase.contains(.began), ended: !e.phase.isDisjoint(with: [.ended, .cancelled]), over: over)
      if mine { pinchBoard(e) }
      return mine
    default:
      return false
    }
  }
}

/// A view on the board: the window sends it the scroll and pinch events under the pointer, and it hands them to the
/// board first (`CanvasView.take`)
class OnBoardView: NSView {
  var handOver: ((NSEvent) -> Bool)?
  override func scrollWheel(with e: NSEvent) { if handOver?(e) != true { super.scrollWheel(with: e) } }
  override func magnify(with e: NSEvent) { if handOver?(e) != true { super.magnify(with: e) } }
}

/// A label's or a title's field on the board (its field editor passes the events it does not use up to it)
final class OnBoardField: NSTextField {
  var handOver: ((NSEvent) -> Bool)?
  override func scrollWheel(with e: NSEvent) { if handOver?(e) != true { super.scrollWheel(with: e) } }
  override func magnify(with e: NSEvent) { if handOver?(e) != true { super.magnify(with: e) } }
}

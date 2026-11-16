import AppKit
import CodeBoardCanvas

/// Cards dragged out of a canvas onto another window's (it asks at every step from then on): their picture follows
/// the pointer in a borderless window of its own, moved as a whole, and the board canvas in front under the pointer
/// marks where they would land. Let go there: on another board, Copy there and Paste here (shared cards); on the same
/// board shown in another window, they move there. Anywhere else, or after Esc, nothing changes
@MainActor final class CardDrag: CardDragging {
  private weak var set: WindowSet?
  /// Puts the picture on screen; tests, whose windows never are, keep it off
  var showPicture: (NSWindow) -> Void = { $0.orderFront(nil) }
  private var picture: NSWindow?
  private var grab = CGPoint.zero
  private var over: CanvasView?
  private var cancelled = false
  private var escape: Any?

  init(set: WindowSet) {
    self.set = set
  }

  /// Only another window's board canvas, in front under the pointer
  func takesCards(from canvas: CanvasView, at p: CGPoint) -> Bool {
    set?.canvas(at: p).map { $0.canvas !== canvas } ?? false
  }

  func cardsOut(of canvas: CanvasView, at p: CGPoint, picture made: () -> (NSImage, CGPoint)?) {
    guard !cancelled, let set else { return }
    if picture == nil, let (image, at) = made() {
      picture = Self.window(image, near: canvas.window)
      grab = at
      if let w = picture { showPicture(w) }
      listenForEscape()
    }
    picture?.setFrameTopLeftPoint(CGPoint(x: p.x - grab.x, y: p.y + grab.y))
    let target = set.canvas(at: p).flatMap { $0.canvas === canvas ? nil : $0.canvas }
    if over !== target { over?.showCardsDrop(nil, at: nil) }
    over = target
    target?.showCardsDrop(canvas.cardsOut, at: target?.boardPoint(onScreen: p))
  }

  func cardsBack(to canvas: CanvasView) -> Bool {
    guard !cancelled else { return false }
    end()
    return true
  }

  func cardsDropped(from canvas: CanvasView, at p: CGPoint) -> CGPoint? {
    let was = cancelled
    end()
    cancelled = false
    guard !was, let set, let out = canvas.cardsOut,
      let (e, target) = set.canvas(at: p), target !== canvas, let at = target.boardPoint(onScreen: p)
    else { return nil }
    set.focus(e.window)
    // one board in two windows: the cards move on it
    if target.document?.id == out.board { return at }
    target.receiveCards(out, at: at)
    return nil
  }

  /// Esc while cards are out: their picture and the mark gone; let go, nothing changes
  func cancel() {
    guard picture != nil || over != nil else { return }
    end()
    cancelled = true
  }

  private func end() {
    picture?.orderOut(nil)
    picture = nil
    over?.showCardsDrop(nil, at: nil)
    over = nil
    if let escape { NSEvent.removeMonitor(escape) }
    escape = nil
  }

  private static func window(_ image: NSImage, near window: NSWindow?) -> NSWindow {
    let w = NSPanel(
      contentRect: CGRect(origin: .zero, size: image.size), styleMask: [.borderless, .nonactivatingPanel],
      backing: .buffered, defer: false)
    w.isOpaque = false
    w.backgroundColor = .clear
    w.hasShadow = true
    w.ignoresMouseEvents = true
    w.level = .popUpMenu
    w.isReleasedWhenClosed = false
    w.alphaValue = 0.85
    if let window { w.appearance = window.effectiveAppearance }
    let view = NSImageView(frame: CGRect(origin: .zero, size: image.size))
    view.image = image
    view.imageScaling = .scaleNone
    w.contentView = view
    return w
  }

  private func listenForEscape() {
    guard escape == nil else { return }
    escape = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] e in
      guard e.keyCode == 53, let self, picture != nil else { return e }
      cancel()
      return nil
    }
  }
}

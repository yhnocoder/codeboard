import AppKit
import CodeBoardModel

/// Cards dragged out of their canvas, to another window's canvas (the app's windows: the canvas knows none of them).
/// The canvas tells where the pointer is on screen while it is out of its view, with a picture of the cards made once
@MainActor public protocol CardDragging: AnyObject {
  /// The pointer at `p` on screen, out of `canvas`'s view, dragging its `cardsOut`; `picture` (made when first asked):
  /// the cards as drawn and where the pointer is in it (y down)
  func cardsOut(of canvas: CanvasView, at p: CGPoint, picture: () -> (NSImage, CGPoint)?)
  /// The pointer back over `canvas`: true, its drag goes on; false (put back with Esc), the cards stay until let go
  func cardsBack(to canvas: CanvasView) -> Bool
  /// Let go at `p` out of `canvas`'s view: where to move the cards to on the same board shown in another window (board
  /// units), else nil (taken by another board, or nothing)
  func cardsDropped(from canvas: CanvasView, at p: CGPoint) -> CGPoint?
}

/// What a canvas's cards dragged out of it carry: the cards as Copy puts them, and where they were held
public struct CardsOut {
  public let board: BoardID
  public let clip: Clip
  /// The press, in the board's units
  public let grab: CGPoint
  /// Put back with Esc: let go, nothing changes
  var stayed = false
}

extension CanvasView {
  /// A card drag's pointer out of the view goes to `cardDragging`: the cards go back where they were while it is out,
  /// and nothing is drawn; back over the view, the drag goes on. True: out (the drag does nothing here)
  func dragOut(_ m: Move, _ g: Gesture, _ e: NSEvent) -> Bool {
    guard let hook = cardDragging, let w = window else { return false }
    let v = convert(e.locationInWindow, from: nil)
    if visibleRect.contains(v) {
      guard let out = cardsOut else { return false }
      if out.stayed { return true }
      if hook.cardsBack(to: self) {
        cardsOut = nil
        return false
      }
      cardsOut?.stayed = true
      return true
    }
    if cardsOut == nil {
      guard let (board, vault) = shown, let doc = document else { return false }
      let picture = cardsPicture(m, at: v)
      cardsOut = CardsOut(board: board.id, clip: doc.board.clip(m.cards) { try? vault.sharedCard($0) }, grab: g.start)
      putBack(m)
      hook.cardsOut(of: self, at: w.convertPoint(toScreen: e.locationInWindow), picture: { picture })
      return true
    }
    if cardsOut?.stayed == false {
      hook.cardsOut(of: self, at: w.convertPoint(toScreen: e.locationInWindow), picture: { nil })
    }
    return true
  }

  /// Let go out of the view: the cards stay where they are here, or move on this board where another window showing it
  /// takes them (one step)
  func dropOut(_ m: Move, _ e: NSEvent) {
    guard let hook = cardDragging, let w = window, let out = cardsOut else { return }
    // the hook reads what is out
    let to = hook.cardsDropped(from: self, at: w.convertPoint(toScreen: e.locationInWindow))
    cardsOut = nil
    guard !out.stayed, let to else {
      gesture = nil
      return drawChrome()
    }
    var moved = m
    moved.d = CGVector(dx: to.x - out.grab.x, dy: to.y - out.grab.y)
    commitMove(moved)
  }

  /// The dragged cards back where they were, nothing lined up or dropped into
  private func putBack(_ m: Move) {
    snapSettle?.cancel()
    showGuides([])
    land()
    clearDrop()
    showScene(arrows: m.arrows, items: m.items, frames: m.frames)
    drawChrome()
  }

  /// The moved items as drawn now (what is on screen, nothing drawn again), and where `v` is in it
  private func cardsPicture(_ m: Move, at v: CGPoint) -> (NSImage, CGPoint)? {
    guard let s = scene else { return nil }
    let box = m.items.reduce(CGRect.null) { r, i in
      let it = s.items[i].rect.offsetBy(dx: m.d.dx, dy: m.d.dy)
      return r.union(
        CGRect(
          origin: camera.view(it.origin), size: CGSize(width: it.width * camera.zoom, height: it.height * camera.zoom)))
    }.intersection(bounds).integral
    guard !box.isNull, box.width > 0, box.height > 0, let rep = bitmapImageRepForCachingDisplay(in: box) else {
      return nil
    }
    cacheDisplay(in: box, to: rep)
    let image = NSImage(size: box.size)
    image.addRepresentation(rep)
    return (image, CGPoint(x: v.x - box.minX, y: v.y - box.minY))
  }

  // MARK: Cards from another window

  /// A point on screen in the board's units; nil out of the window
  public func boardPoint(onScreen p: CGPoint) -> CGPoint? {
    guard let w = window else { return nil }
    return camera.board(convert(w.convertPoint(fromScreen: p), from: nil))
  }

  /// Where cards dragged from another window would land, a light mark; nil: none
  public func showCardsDrop(_ out: CardsOut?, at p: CGPoint?) {
    guard let out, let p else {
      if let l = cardsDropLayer, l.path != nil { withoutAnimation { l.path = nil } }
      return
    }
    let r = out.landing(at: p)
    let l = cardsDropLayer ?? CAShapeLayer()
    if cardsDropLayer == nil {
      l.zPosition = 900
      layer?.addSublayer(l)
      cardsDropLayer = l
    }
    let v = CGRect(
      origin: camera.view(r.origin), size: CGSize(width: r.width * camera.zoom, height: r.height * camera.zoom))
    withoutAnimation {
      l.frame = bounds
      l.path = CGPath(roundedRect: v, cornerWidth: 8, cornerHeight: 8, transform: nil)
      l.fillColor = theme.accent.copy(alpha: 0.06)
      l.strokeColor = theme.accent.copy(alpha: 0.45)
      l.lineWidth = 1.5
      l.lineDashPattern = [5, 4]
    }
  }

  /// Cards dragged here from another board let go at `p` (board units): what Copy there and Paste here do (shared by
  /// both), the press where the pointer is and the cards as they were arranged, one step, selected
  public func receiveCards(_ out: CardsOut, at p: CGPoint) {
    guard gesture == nil, out.board != shown?.board.id else { return }
    pasteShared(out.clip, from: out.board, dx: (p.x - out.grab.x).rounded(), dy: (p.y - out.grab.y).rounded())
  }
}

extension CardsOut {
  /// The cards' box once the press is at `p`
  func landing(at p: CGPoint) -> CGRect {
    let rects = clip.cards.map {
      CGRect(x: $0.x, y: $0.y, width: $0.width, height: $0.height ?? $0.measuredHeight ?? 120)
    }
    let box = rects.dropFirst().reduce(rects.first ?? .zero) { $0.union($1) }
    return box.offsetBy(dx: p.x - grab.x, dy: p.y - grab.y)
  }
}

import AppKit
import CodeBoardModel

// Tidy Up's slide (actions/common.ts slideFrom): the cards it moved are shown where they were the moment the scene with
// their new places comes in, and slide there on the web board's spring (Spring(0, 170, 26, 0.002), Card.tsx's
// translate((1 - v) · offset)), only their layers' positions changing; the arrows on them follow, as routes.ts endOf
// adds the offset. The Sections it moved ease as with Fit Content (the scene swap's easeFrames).

/// A slide under way: each card's offset from its new place to where it was, and the spring taking it from 0 to 1
struct TidySlide {
  var from: [CardID: CGVector]
  var v: CGFloat = 0
  var vel: CGFloat = 0
  /// The scene with the new places is in (until then the old one shows them where they were)
  var started = false
  /// Their places in it: a later scene that has them elsewhere (an undo) ends the slide
  var to: [CardID: CGPoint] = [:]
  var at: TimeInterval?

  /// Spring.step: four substeps of k 170, c 26 towards 1
  mutating func step(_ dt: TimeInterval) {
    let h = CGFloat(dt) / 4
    for _ in 0..<4 {
      vel += (-170 * (v - 1) - 26 * vel) * h
      v += vel * h
    }
  }

  var done: Bool { abs(v - 1) < 0.002 && abs(vel) < 0.02 }
}

extension CanvasView {
  /// The scene swap (reinstall) put every card at its new place: the slid ones go back to where the slide has them
  func showTidySlide() {
    guard var t = tidySlide, let s = scene else { return }
    let to = t.from.keys.reduce(into: [CardID: CGPoint]()) { $0[$1] = s.placed[$1]?.rect.origin }
    if !t.started {
      t.started = true
      t.to = to
      tidySlide = t
      wake()
    } else if to != t.to {
      tidySlide = nil
      return
    }
    placeSlid(t, s)
  }

  /// A frame of it (tick): the spring steps (as the web board's animate, at most 32 ms a frame) and the cards follow
  func stepTidySlide(at time: TimeInterval) {
    guard var t = tidySlide, t.started, let s = scene else { return }
    // a drag or resize takes the cards from where they are going
    if gesture != nil { (t.v, t.vel) = (1, 0) }
    t.step(min(max(time - (t.at ?? time), 0), 0.032))
    t.at = time
    if t.done {
      t.v = 1
      tidySlide = nil
    } else {
      tidySlide = t
    }
    placeSlid(t, s)
    // landed: on device pixels, as every card at rest
    if tidySlide == nil { settleOnPixels() }
  }

  private func placeSlid(_ t: TidySlide, _ s: Scene) {
    let k = 1 - t.v
    var arrows: [Int] = []
    for (i, a) in s.arrowModels.enumerated() where t.from[a.from.card] != nil || t.from[a.to.card] != nil {
      arrows.append(i)
    }
    withoutAnimation {
      for (i, it) in s.items.enumerated() {
        guard case .card(let id)? = it.owner, let o = t.from[id] else { continue }
        items[i].box.position = CGPoint(x: it.rect.midX + o.dx * k, y: it.rect.midY + o.dy * k)
      }
      reroute(arrows) { id in
        guard var p = s.placed[id] else { return nil }
        if let o = t.from[id] { p.rect = p.rect.offsetBy(dx: o.dx * k, dy: o.dy * k) }
        return p
      }
    }
  }
}
